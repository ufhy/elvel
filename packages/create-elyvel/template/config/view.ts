export default {
  /**
   * Prepend `<!DOCTYPE html>` when a view renders a full `<html>` document.
   * JSX has no doctype node, so this saves every layout from carrying it.
   */
  doctype: true,

  /** Serve `public/` through @elysiajs/static. */
  serveStatic: true,

  staticPrefix: '/'
}
