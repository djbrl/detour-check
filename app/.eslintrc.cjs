// Catches the mistakes that broke Rovo before (a name used but never imported) without a style debate.
module.exports = {
  root: true,
  parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
  env: { es2022: true, node: true },
  extends: ['eslint:recommended'],
  rules: { 'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  overrides: [{ files: ['static/brief/src/**/*.js'], env: { browser: true, node: false } }],
  ignorePatterns: ['node_modules/', 'static/brief/build/', 'static/brief/node_modules/'],
};
