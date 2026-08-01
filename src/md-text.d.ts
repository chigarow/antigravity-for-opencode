/**
 * Module declaration for importing `*.md` files as raw text.
 *
 * Bun's bundler and runtime treat `.md` as text via the `bunfig.toml`
 * `[loader]` configuration, so the default export is always the file's
 * raw string content. This declaration lets `tsc --noEmit` resolve the
 * import without a separate type for each `.md` file.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
