import { describe, expect, test } from 'bun:test'
import { ArrayBatchRepository } from '../src/batch.ts'
import type { JobPayload } from '../src/contracts.ts'
import { FakeQueue, QueueFake } from '../src/fake.ts'
import { Job } from '../src/job.ts'

class ImportRow extends Job<{ row: number }> {
  async handle(): Promise<void> {}
}

class Extract extends Job {
  async handle(): Promise<void> {}
}

const payload = (job: string, extra: Partial<JobPayload> = {}): JobPayload => ({
  uuid: crypto.randomUUID(),
  job,
  displayName: job,
  data: {},
  attempts: 0,
  createdAt: 0,
  ...extra
})

function fake() {
  const driver = new FakeQueue('fake', 'default')

  return { driver, assert: new QueueFake(driver) }
}

/** Ordering is the only reason to use a chain rather than three dispatches. */
describe('the fake sees a chain', () => {
  test('assertChained checks the links and their order', async () => {
    const { driver, assert } = fake()

    await driver.push(payload('Extract', { chain: [payload('Transform'), payload('Load')] }))

    assert.assertChained('Extract', ['Transform', 'Load'])

    expect(() => assert.assertChained('Extract', ['Load', 'Transform'])).toThrow(
      'Transform -> Load'
    )
  })

  test('assertDispatchedWithoutChain catches one added by mistake', async () => {
    const { driver, assert } = fake()

    await driver.push(payload('Extract'))

    assert.assertDispatchedWithoutChain('Extract')

    await driver.push(payload('Load', { chain: [payload('Notify')] }))

    expect(() => assert.assertDispatchedWithoutChain('Load')).toThrow('it carried [Notify]')
  })

  test('assertNothingChained', async () => {
    const { driver, assert } = fake()

    await driver.push(payload('Extract'))

    assert.assertNothingChained()

    await driver.push(payload('Load', { chain: [payload('Notify')] }))

    expect(() => assert.assertNothingChained()).toThrow('Load -> Notify')
  })
})

describe('the fake sees a batch', () => {
  test('assertBatched and assertBatchCount', async () => {
    const { driver, assert } = fake()

    await driver.push(payload('ImportRow', { batchId: 'b1' }))
    await driver.push(payload('ImportRow', { batchId: 'b1' }))

    assert.assertBatched(['ImportRow', 'ImportRow'])
    assert.assertBatchCount(1)

    expect(() => assert.assertBatched(['Other'])).toThrow('Expected a batch of [Other]')
  })

  test('assertNothingBatched', async () => {
    const { driver, assert } = fake()

    await driver.push(payload('Loose'))

    assert.assertNothingBatched()
  })
})

/** Without this a batch must know its size before the first job runs. */
describe('a batch can grow', () => {
  const repository = () => new ArrayBatchRepository()

  const stored = async (repo: ArrayBatchRepository, total = 2) =>
    repo.store({
      id: 'b1',
      name: 'import',
      totalJobs: total,
      pendingJobs: total,
      failedJobs: 0,
      failedJobIds: [],
      options: {},
      createdAt: 0
    })

  test('the counts move with it', async () => {
    const repo = repository()
    const batch = await stored(repo)

    const queued: number[] = []
    const grown = await batch.add(
      [new ImportRow({ row: 3 }), new ImportRow({ row: 4 })],
      async (jobs) => queued.push(jobs.length)
    )

    expect(grown.totalJobs).toBe(4)
    expect(grown.pendingJobs).toBe(4)
    expect(queued).toEqual([2])
  })

  /** The counts rise before the jobs go out, or a fast worker finishes it early. */
  test('and rise before anything is queued', async () => {
    const repo = repository()
    const batch = await stored(repo)

    let totalWhenQueued = 0

    await batch.add([new ImportRow({ row: 3 })], async () => {
      totalWhenQueued = (await repo.find('b1'))?.totalJobs ?? 0
    })

    expect(totalWhenQueued).toBe(3)
  })

  test('adding nothing is not an error and queues nothing', async () => {
    const repo = repository()
    const batch = await stored(repo)
    let called = false

    await batch.add([], async () => {
      called = true
    })

    expect(called).toBe(false)
  })

  /** Its callbacks have already run: nothing is waiting for the new work. */
  test('a finished batch refuses', async () => {
    const repo = repository()
    const batch = await stored(repo, 1)

    await repo.recordSuccess('b1', 'job-1')

    const finished = await repo.find('b1')

    await expect(
      (finished as NonNullable<typeof finished>).add([new ImportRow({ row: 1 })], async () => {})
    ).rejects.toThrow('already finished')
  })

  test('and a cancelled one refuses too', async () => {
    const repo = repository()
    await stored(repo)
    await repo.cancel('b1')

    const cancelled = await repo.find('b1')

    await expect(
      (cancelled as NonNullable<typeof cancelled>).add([new ImportRow({ row: 1 })], async () => {})
    ).rejects.toThrow('was cancelled')
  })
})

/** A running job could not put work in front of the links still to come. */
describe('a job can change its own chain', () => {
  test('prependToChain puts work first', () => {
    const job = new Extract({})
    const load = payload('Load')

    job.setQueuedJob({ payload: payload('Extract', { chain: [load] }) } as never)
    job.prependToChain(payload('Validate'))

    expect(job.remainingChain().map((one) => one.job)).toEqual(['Validate', 'Load'])
  })

  test('appendToChain puts it last', () => {
    const job = new Extract({})

    job.setQueuedJob({ payload: payload('Extract', { chain: [payload('Load')] }) } as never)
    job.appendToChain(payload('Notify'))

    expect(job.remainingChain().map((one) => one.job)).toEqual(['Load', 'Notify'])
  })

  test('and a job that changed nothing keeps what it was given', () => {
    const job = new Extract({})

    job.setQueuedJob({ payload: payload('Extract', { chain: [payload('Load')] }) } as never)

    expect(job.remainingChain().map((one) => one.job)).toEqual(['Load'])
  })
})
