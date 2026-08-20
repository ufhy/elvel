# Bootstrap order

Fixed, and it mirrors `Illuminate\Foundation\Http\Kernel`:

```
env -> config -> exceptions -> register providers -> boot providers -> routes
```

Framework providers come from `config/app.ts`; application providers are passed
to `Application.configure().withProviders()` so they register last and can
override framework bindings. Events and logging are registered first, as
Laravel's base providers are, because everything booting after them may emit
events or write logs.
