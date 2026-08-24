/// <reference types="vite/client" />

/*
 * No `declare module '*.vue'` here, and that is deliberate.
 *
 * A shim like that types every component as `DefineComponent<{}, {}, unknown>`,
 * which makes plain `tsc` stop complaining and also stops it checking a single
 * prop. `vue-tsc` reads the components themselves, so the shim would only hide
 * what it is here to find.
 */
