export default [{
  ignores: ["node_modules/**", "coverage/**"],
}, {
  files: ["**/*.js", "**/*.mjs"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: {
    "constructor-super": "error",
    "no-unreachable": "error",
    "no-dupe-args": "error",
    "no-dupe-keys": "error",
    "no-duplicate-case": "error",
    "no-constant-condition": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    "valid-typeof": "error",
  },
}];
