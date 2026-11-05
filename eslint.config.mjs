import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nodePlugin from 'eslint-plugin-n';
import functional from 'eslint-plugin-functional';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

// Rule philosophy mirrors ../pels (the modern flat-config bar), adapted to this
// single Homey app. `npm run lint` runs `eslint . --max-warnings=0`, so `warn`
// and `error` both fail CI; the split only changes editor colour.

const sharedTypeScriptRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  '@typescript-eslint/no-unsafe-call': 'warn',
  '@typescript-eslint/consistent-type-definitions': ['warn', 'type'],
  '@typescript-eslint/no-restricted-types': ['warn'],
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-require-imports': 'off',
};

const sharedGeneralRules = {
  'no-console': 'off',
  'no-trailing-spaces': 'error',
  'max-len': ['warn', { code: 120 }],
  'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
  'max-depth': ['warn', 4],
  'max-nested-callbacks': ['warn', 3],
  'max-params': ['warn', 5],
  'max-statements': ['warn', 30],
  complexity: ['warn', 15],
  'comma-dangle': ['error', 'always-multiline'],
  'operator-linebreak': ['error', 'before'],
  'no-else-return': 'warn',
  'no-implicit-coercion': 'warn',
  'no-multi-assign': 'warn',
  'no-nested-ternary': 'warn',
  'no-param-reassign': ['warn', { props: true }],
  'prefer-const': 'warn',
  'consistent-return': 'warn',
};

const sharedSonarRules = {
  'sonarjs/cognitive-complexity': ['warn', 15],
  'sonarjs/no-duplicated-branches': 'warn',
  'sonarjs/no-identical-functions': 'warn',
  'sonarjs/no-inverted-boolean-check': 'warn',
  'sonarjs/no-redundant-boolean': 'warn',
  'sonarjs/no-small-switch': 'warn',
};

const nodeTypeScriptRules = {
  ...sharedTypeScriptRules,
  ...sharedGeneralRules,
  ...sharedSonarRules,
  // Disabled (sole divergence from pels): this app is deliberately imperative,
  // ported from flexit's BACnet polling style. pels enables this because pels is
  // functional-leaning; forcing it here would only buy obfuscating workarounds.
  'functional/immutable-data': 'off',
  'unicorn/no-for-each': 'warn',
  'unicorn/prefer-node-protocol': 'warn',
  'n/no-unsupported-features/node-builtins': ['error', {
    version: '>=22.0.0',
    ignores: ['fetch'],
  }],
  'n/no-unsupported-features/es-syntax': ['error', { version: '>=22.0.0', ignores: ['modules'] }],
};

const scriptRuleRelaxations = {
  complexity: ['warn', 60],
  'max-depth': ['warn', 6],
  'max-lines': ['warn', { max: 1700, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 220, skipBlankLines: true, skipComments: true }],
  'max-params': ['warn', 8],
  'max-statements': ['warn', 100],
  'sonarjs/cognitive-complexity': ['warn', 60],
};

const testRuleRelaxations = {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/ban-ts-comment': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/no-this-alias': 'off',
  '@typescript-eslint/no-unused-vars': 'warn',
  'max-params': 'off',
  'no-param-reassign': 'off',
  'n/no-missing-import': 'off',
  'n/no-unpublished-import': 'off',
  'n/no-unsupported-features/es-syntax': 'off',
  'functional/immutable-data': 'off',
  complexity: 'off',
  'max-lines': 'off',
  'max-lines-per-function': 'off',
  'max-statements': 'off',
  'max-nested-callbacks': 'off',
  'sonarjs/cognitive-complexity': 'off',
  'sonarjs/no-identical-functions': 'off',
  'sonarjs/no-duplicated-branches': 'off',
  'max-len': 'off',
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      '.homeybuild/**',
      'coverage/**',
      '.claude/**',
      '.codex/**',
      'localdocs/**',
      'assets/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      '**/*.mts',
    ],
  },
  {
    files: ['**/*.ts'],
    plugins: {
      functional,
      n: nodePlugin,
      sonarjs,
      unicorn,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: nodeTypeScriptRules,
  },
  {
    files: ['scripts/**/*.ts'],
    rules: scriptRuleRelaxations,
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
      parserOptions: {
        project: false,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: testRuleRelaxations,
  },
);
