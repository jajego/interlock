import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", ".packs/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
