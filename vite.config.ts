import { defineConfig } from 'vite-plus'

export default defineConfig({
  resolve: {
    tsconfigPaths: true
  },

  fmt: {
    // Copied from Viaanix/oxc-config-viaanix v4.0.0: formatterOverride({ maxLineLength: 100, tabWidth: 2 }).
    semi: false,
    singleQuote: true,
    trailingComma: 'none',
    quoteProps: 'consistent',
    bracketSpacing: true,
    arrowParens: 'always',
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    insertFinalNewline: true,
    sortImports: true,
    // Prose and generated files stay as written.
    ignorePatterns: ['**/*.md', 'pnpm-lock.yaml']
  },

  lint: {
    // Rules copied from Viaanix/oxc-config-viaanix v4.0.0 (1a27314) plus its uncommitted
    // `max-statements: off` test override: oxlintrc.json, oxlintrc.ts.json,
    // oxlintrc.type-aware.json, and oxlintrc.strict.json, flattened. Repo additions follow.
    // Viaanix: skip hidden folders, build output, and docs.
    ignorePatterns: ['.*/', 'dist/', 'docs/'],
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: 'deny',
      maxWarnings: 0
    },
    plugins: ['import', 'node', 'promise', 'unicorn', 'typescript', 'oxc'],
    categories: { correctness: 'error', suspicious: 'warn' },
    env: { builtin: true, node: true, es2024: true },
    jsPlugins: [
      { name: 'zod', specifier: 'eslint-plugin-zod' },
      { name: '@limegrass/import-alias', specifier: '@limegrass/eslint-plugin-import-alias' },
      { name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' },
      './lint/repo-rules.ts'
    ],
    rules: {
      // Viaanix base + type-aware
      'unicorn/consistent-function-scoping': 'off',
      'no-underscore-dangle': 'off',
      'no-implicit-coercion': 'error',
      'max-params': ['error', { max: 4 }],
      'no-nested-ternary': 'error',
      'no-console': 'warn',
      'unicorn/explicit-length-check': 'error',
      'unicorn/throw-new-error': 'error',
      'unicorn/numeric-separators-style': ['error', { onlyIfContainsSeparator: true }],
      'complexity': ['error', { max: 15 }],
      'no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true
        }
      ],
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-empty-static-block': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-regex-spaces': 'error',
      'no-self-assign': ['error', { props: true }],
      'no-setter-return': 'error',
      'no-shadow': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-unexpected-multiline': 'error',
      'preserve-caught-error': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      // repo: stricter than Viaanix (args: none)
      'no-unused-vars': [
        'error',
        { args: 'all', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-with': 'error',
      'require-yield': 'error',
      'use-isnan': ['error', { enforceForIndexOf: true, enforceForSwitchCase: true }],
      'valid-typeof': ['error', { requireStringLiterals: true }],
      'accessor-pairs': ['error', { enforceForClassMembers: true, setWithoutGet: true }],
      'array-callback-return': ['error', { allowImplicit: false, checkForEach: false }],
      'curly': ['error', 'multi-line'],
      'default-case-last': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'new-cap': ['error', { capIsNew: false, newIsCap: true, properties: true }],
      'no-array-constructor': 'error',
      'no-caller': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implied-eval': 'error',
      'no-iterator': 'error',
      'no-labels': ['error', { allowLoop: false, allowSwitch: false }],
      'no-lone-blocks': 'error',
      'no-multi-str': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-object-constructor': 'error',
      'no-new-wrappers': 'error',
      'no-proto': 'error',
      'no-return-assign': ['error', 'except-parens'],
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-template-curly-in-string': 'error',
      'no-throw-literal': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTaggedTemplates: true, allowTernary: true }
      ],
      'no-use-before-define': ['error', { classes: false, functions: false, variables: false }],
      'no-useless-call': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-constructor': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-var': 'warn',
      'no-void': ['error', { allowAsStatement: true }],
      'object-shorthand': ['warn', 'properties'],
      'one-var': ['error', { initialized: 'never' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-promise-reject-errors': 'error',
      'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
      'symbol-description': 'error',
      'unicode-bom': ['error', 'never'],
      'yoda': ['error', 'never'],
      'promise/param-names': 'error',
      'import/first': 'error',
      'import/no-absolute-path': ['error', { amd: false, commonjs: true, esmodule: true }],
      'import/no-duplicates': 'error',
      'import/no-named-default': 'error',
      'import/no-webpack-loader-syntax': 'error',
      'node/handle-callback-err': ['error', '^(err|error)$'],
      'node/no-exports-assign': 'error',
      'node/no-new-require': 'error',
      'node/no-path-concat': 'error',
      'no-useless-concat': 'error',
      'prefer-template': 'error',
      'no-duplicate-imports': ['error', { includeExports: true, allowSeparateTypeImports: true }],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'start' }],
      'unicorn/no-abusive-eslint-disable': 'error',
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'no-param-reassign': 'error',
      'max-depth': ['error', { max: 4 }],
      'guard-for-in': 'error',
      'prefer-object-has-own': 'error',
      'unicorn/error-message': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'radix': 'error',
      'no-constructor-return': 'error',
      'no-loop-func': 'error',
      'oxc/no-accumulating-spread': 'error',
      'import/no-cycle': 'error',
      'no-negated-condition': 'error',
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-statements': ['warn', { max: 30 }],
      'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
      'typescript/no-floating-promises': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/await-thenable': 'error',
      'typescript/switch-exhaustiveness-check': 'error',
      'typescript/only-throw-error': 'error',
      'typescript/no-unsafe-type-assertion': 'error', // repo: stricter than Viaanix (off)
      'typescript/no-deprecated': 'error',

      // Repo additions
      'typescript/no-unnecessary-type-assertion': 'error',
      'typescript/no-unnecessary-condition': 'error',
      'unicorn/new-for-builtins': 'error',
      'unicorn/no-array-for-each': 'error',
      'repo/no-enum': 'error',
      'repo/no-delete': 'error',
      'repo/no-implicit-any-let': 'error',
      'import/namespace': 'error',

      // Zod
      'zod/array-style': 'error',
      'zod/consistent-import': 'error',
      'zod/consistent-import-source': ['error', { sources: ['zod', 'zod/mini'] }],
      'zod/consistent-object-schema-type': ['error', { allow: ['object', 'looseObject'] }],
      'zod/no-any-schema': 'error',
      'zod/no-empty-custom-schema': 'error',
      'zod/no-number-schema-with-int': 'error',
      'zod/no-string-schema-with-uuid': 'error',
      'zod/no-optional-and-default-together': ['error', { preferredMethod: 'default' }],
      'zod/no-throw-in-refine': 'error',
      'zod/no-unknown-schema': 'off',
      'zod/prefer-enum-over-literal-union': 'error',
      'zod/prefer-meta': 'error',
      'zod/prefer-meta-last': 'error',
      'zod/prefer-string-schema-with-trim': 'error',
      'zod/require-brand-type-parameter': 'error',
      'zod/require-error-message': 'error',
      'zod/require-schema-suffix': 'error',
      'zod/schema-error-property-style': 'error',

      '@limegrass/import-alias/import-alias': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error'
    },
    overrides: [
      // Viaanix: test files
      {
        files: ['**/*.test.*', '**/*.spec.*'],
        plugins: ['vitest'],
        rules: {
          'no-magic-numbers': 'off',
          'node/no-process-env': 'error',
          'vitest/no-conditional-expect': 'error',
          'vitest/max-nested-describe': ['error', { max: 5 }],
          'vitest/valid-expect': ['error', { maxArgs: 2 }],
          'vitest/no-disabled-tests': 'error',
          'vitest/warn-todo': 'warn',
          'vitest/require-mock-type-parameters': 'off',
          'vitest/require-to-throw-message': 'off',
          'vitest/no-commented-out-tests': 'error',
          'vitest/no-identical-title': 'error',
          'vitest/expect-expect': [
            'error',
            { assertFunctionNames: ['expect', 'expect*', 'assert*'] }
          ],
          'max-lines-per-function': 'off',
          'max-statements': 'off'
        }
      },
      // Viaanix: TypeScript files (ts + strict)
      {
        files: ['**/*.{ts,tsx,mts,cts}'],
        rules: {
          'no-empty-function': 'error',
          'typescript/ban-ts-comment': ['error', { minimumDescriptionLength: 10 }],
          'typescript/no-duplicate-enum-values': 'error',
          'typescript/no-dynamic-delete': 'error',
          'typescript/no-empty-object-type': 'error',
          'typescript/no-explicit-any': 'error',
          'typescript/no-extra-non-null-assertion': 'error',
          'typescript/no-extraneous-class': 'error',
          'typescript/no-invalid-void-type': 'error',
          'typescript/no-misused-new': 'error',
          'typescript/no-namespace': 'error',
          'typescript/no-non-null-asserted-nullish-coalescing': 'error',
          'typescript/no-non-null-asserted-optional-chain': 'error',
          'typescript/no-non-null-assertion': 'error',
          'typescript/no-require-imports': 'error',
          'typescript/no-this-alias': 'error',
          'typescript/no-unnecessary-type-constraint': 'error',
          'typescript/no-unsafe-declaration-merging': 'error',
          'typescript/no-unsafe-function-type': 'error',
          'typescript/no-wrapper-object-types': 'error',
          'typescript/prefer-as-const': 'error',
          'typescript/prefer-literal-enum-member': 'error',
          'typescript/prefer-namespace-keyword': 'error',
          'typescript/triple-slash-reference': 'error',
          'typescript/unified-signatures': 'error',
          'typescript/adjacent-overload-signatures': 'error',
          'typescript/array-type': 'error',
          'typescript/ban-tslint-comment': 'error',
          'typescript/class-literal-property-style': 'error',
          'typescript/consistent-generic-constructors': 'error',
          'typescript/consistent-indexed-object-style': 'error',
          'typescript/consistent-type-assertions': 'error',
          'typescript/consistent-type-definitions': 'error',
          'typescript/no-confusing-non-null-assertion': 'error',
          'typescript/no-inferrable-types': 'error',
          'typescript/prefer-for-of': 'error',
          'typescript/prefer-function-type': 'error',
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-with': 'off',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
          'typescript/consistent-type-imports': 'error',
          'typescript/explicit-function-return-type': [
            'warn',
            {
              allowExpressions: true,
              allowTypedFunctionExpressions: true,
              allowHigherOrderFunctions: true
            }
          ],
          'typescript/no-unsafe-argument': 'error',
          'typescript/no-unsafe-assignment': 'error',
          'typescript/no-unsafe-call': 'error',
          'typescript/no-unsafe-member-access': 'error',
          'typescript/no-unsafe-return': 'error',
          'typescript/strict-boolean-expressions': 'error'
        }
      },
      // Viaanix: TypeScript test files
      {
        files: ['**/*.test.{ts,tsx,mts,cts}', '**/*.spec.{ts,tsx,mts,cts}'],
        rules: {
          'no-empty-function': 'off',
          'typescript/explicit-function-return-type': 'off',
          'typescript/no-non-null-assertion': 'off'
        }
      },
      // Repo overrides
      {
        files: ['**/*.test.ts'],
        rules: {
          'typescript/await-thenable': 'off',
          'typescript/unbound-method': 'off',
          'typescript/no-floating-promises': 'off',
          'typescript/no-unsafe-assignment': 'off',
          'typescript/no-unsafe-member-access': 'off',
          'typescript/no-unsafe-argument': 'off',
          'typescript/consistent-type-assertions': 'off',
          'typescript/no-unnecessary-type-assertion': 'off',
          'typescript/no-unsafe-type-assertion': 'off'
        }
      },
      {
        // The structured logger and the CLI entry write to stderr by design.
        files: ['src/server/logging.ts', 'src/index.ts'],
        rules: { 'no-console': 'off' }
      }
    ]
  },

  test: {
    include: ['test/**/*.test.ts']
  },

  pack: {
    entry: {
      'index': 'src/index.ts',
      'config': 'src/config/schema.ts',
      'exposure': 'src/openai/model-exposure.ts',
      'sync-zed': 'src/sync/zed.ts'
    },
    format: ['esm'],
    dts: true,
    clean: true,
    banner: (chunk) => {
      if (chunk.fileName === 'index.mjs') {
        return { js: '#!/usr/bin/env node' }
      }
      return {}
    },
    deps: {
      neverBundle: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']
    }
  },

  staged: {
    '*': 'vp check --fix'
  }
})
