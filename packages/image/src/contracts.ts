import type { ImageInfo } from './probe.ts'

export type Fit = 'cover' | 'contain'

/** One step, queued until something asks for bytes. */
export type Transformation =
  | { op: 'resize'; width?: number; height?: number }
  | { op: 'fit'; fit: Fit; width: number; height: number }
  | { op: 'scale'; factor: number }
  | { op: 'crop'; width: number; height: number; x?: number; y?: number }
  | { op: 'rotate'; degrees: number }
  | { op: 'flip'; axis: 'horizontal' | 'vertical' }
  | { op: 'grayscale' }
  | { op: 'blur'; radius: number }
  | { op: 'sharpen'; amount: number }
  | { op: 'orient' }

export type Encoding = {
  /** `png`, `jpeg`, `webp`, … or undefined to keep the source format. */
  format?: ImageInfo['format']
  /** 1–100, for the formats that have a quality dial. */
  quality?: number
}

/**
 * What a driver must do: take bytes and a list of steps, return bytes.
 *
 * `supports` is part of the contract rather than an afterthought. No backend
 * available on Bun does everything — `sips` cannot blur, a machine may have no
 * ImageMagick at all — and a driver that silently skipped a step it could not
 * perform would return an image that looks right and is not. Asking first turns
 * that into an error naming the driver and the step.
 */
export interface ImageDriver {
  readonly name: string
  supports(op: Transformation['op']): boolean
  /** Is the backend actually present on this machine? */
  available(): Promise<boolean>
  apply(bytes: Uint8Array, steps: Transformation[], encoding: Encoding): Promise<Uint8Array>
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageError'
  }
}

/** Every format this package will ask a driver to write. */
export const WRITABLE = ['png', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'avif', 'heic'] as const
