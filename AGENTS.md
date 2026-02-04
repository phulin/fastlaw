* Use `yarn` for package management.
* Write everything in TypeScript, including one-time throwaway scripts.
* Avoid defensive programming. To the extent possible, rely on the type system for guarantees instead.
* Don't worry about backward compatibility inside the codebase. Your primary goal is to keep the code simple and clean; e.g. if you refactor some code and update all callsites, you can delete the old version.
* Ask questions if your instructions are unclear.
* After making edits, run `yarn check:fix && yarn typecheck`.
* Do not re-export types that we import from library packages. Import directly from the package everywhere they're used.
