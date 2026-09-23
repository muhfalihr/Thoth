/**
 * Font files resolve to a URL, in every bundler this package is built by.
 *
 * Remotion's webpack config and Vite both emit a font import as an asset and
 * hand back its served location, so the composition treats the import as the
 * string it is. Declared here because this package ships source only and owns
 * no bundler of its own.
 */

declare module "*.ttf" {
  const url: string;
  export default url;
}
