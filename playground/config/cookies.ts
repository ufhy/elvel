/**
 * Cookies.
 *
 * Everything a route queues with `queueCookie()` goes out encrypted and bound to
 * its own cookie name, so the browser holds something opaque that cannot be moved
 * from one cookie to another. That is what makes the difference between "remember
 * this preference" and "remember that I am an administrator" a matter of nothing.
 */
export default {
  /**
   * Cookies that stay in the clear, by name.
   *
   * For anything something else has to read: an analytics script, or a front-end
   * framework's own XSRF cookie. The session cookie is always excepted — it is
   * signed by the session plugin, and encrypting it twice would leave a value
   * neither half can read.
   */
  except: [] as string[]
}
