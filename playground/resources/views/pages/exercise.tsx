import { Layout } from '../components/layout.tsx'

export type ExerciseProps = {
  title: string
  items: string[]
  /** Deliberately unescaped-looking input, to prove `safe` actually escapes. */
  untrusted: string
}

export function Exercise({ title, items, untrusted }: ExerciseProps) {
  return (
    <Layout title={title}>
      <h1 safe>{title}</h1>

      <ul class="items">
        {items.map((item) => (
          <li safe>{item}</li>
        ))}
      </ul>

      {items.length > 2 ? (
        <p class="hint">More than two items.</p>
      ) : (
        <p class="hint">Two or fewer.</p>
      )}

      <p class="untrusted" safe>
        {untrusted}
      </p>
    </Layout>
  )
}

/** An async component: `JSX.Element` is `string | Promise<string>`. */
export async function DelayedGreeting({ name }: { name: string }) {
  const resolved = await Promise.resolve(name)

  return <p class="async">Hello {resolved}</p>
}
