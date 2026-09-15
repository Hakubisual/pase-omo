/**
 * Mandated component entry for the folder browser.
 *
 * The real component lives in `folders-browser.tsx` because a `folders.ts`
 * + `folders.tsx` same-basename pair is unresolvable: bundler and TypeScript
 * both pick `.ts` over `.tsx` for the `./folders.js` specifier (the repo's
 * own convention — `todo-visual.ts` + `todo-card.tsx`, not `todo.ts(x)` —
 * encodes the same rule), so `folders.tsx` could never be imported. Import
 * the component from `./client/folders-browser.js`.
 */
export {
  FolderBrowser,
  createStyles,
  folderBrowserModel,
  type FolderBrowserLayout,
  type FolderBrowserModel,
  type FolderBrowserProps,
} from "./folders-browser.js";
