import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pins the fast-check seed for every run — see the file for why it is fixed.
    setupFiles: ['./tests/properties/fast-check-seed.ts'],
    // Sibling worktrees live inside the repo and carry their own copy of the
    // suite. Vitest walks the tree rather than reading .gitignore, so without
    // these a run on main also collects whatever another session has on disk.
    exclude: [...configDefaults.exclude, 'worktrees/**', '_to_delete/**'],
  },
});
