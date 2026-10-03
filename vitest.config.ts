// SPDX-License-Identifier: GPL-2.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
