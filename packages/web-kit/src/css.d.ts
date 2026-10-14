// Lets the package type-check on its own. Inside Next the same declaration comes from next-env.d.ts.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
