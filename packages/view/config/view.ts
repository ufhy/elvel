export default {
  /**
   * Prepend `<!DOCTYPE html>` when a view renders a full `<html>` document.
   * JSX has no doctype node, so this saves every layout from carrying it.
   */
  doctype: true,

  /** Serve `public/` through @elysiajs/static. */
  serveStatic: true,

  staticPrefix: '/',

  /**
   * Compress the files in `public/` for callers that accept gzip.
   *
   * `@elysiajs/static` ignores `accept-encoding`, so without this a built page
   * transfers its assets uncompressed — measured at 150 kB where 42 kB would
   * have done. Only files are compressed, never a rendered page.
   *
   * Turn it off if something in front of the application already compresses:
   * nginx, a CDN, or a platform's router. Compressing twice is wasted work.
   */
  compressStatic: true,

  /**
   * Below this many bytes, gzip is not worth it — its own framing can make a
   * small file bigger, and anything under one packet arrives in one either way.
   */
  compressMinimumBytes: 1024
}
