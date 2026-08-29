const js = require("@eslint/js");

module.exports = [
  {
    ignores: ["**/node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        App: "readonly",
        Component: "readonly",
        Page: "readonly",
        getApp: "readonly",
        wx: "readonly",
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-var": "error",
      "prefer-const": "error"
    },
  },
];
