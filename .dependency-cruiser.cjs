/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Prevent circular dependencies.',
      severity: 'error',
      from: { path: '^(app\\.ts|drivers/|lib/)' },
      to: { circular: true },
    },
    {
      name: 'no-runtime-to-tests',
      comment: 'Runtime code must stay isolated from tests.',
      severity: 'error',
      from: { path: '^(app\\.ts|drivers/|lib/)' },
      to: { path: '^test/' },
    },
    {
      name: 'no-lib-to-drivers',
      comment: 'The arrow points drivers -> lib. Shared lib code must not depend on a driver.',
      severity: 'error',
      from: { path: '^lib/' },
      to: { path: '^drivers/' },
    },
    {
      name: 'no-lib-to-app',
      comment: 'lib/ is the reusable core; it must not depend on the app entry point.',
      severity: 'error',
      from: { path: '^lib/' },
      to: { path: '^app\\.ts$' },
    },
    {
      name: 'no-cross-driver',
      comment: 'Drivers must not import each other; share via lib/.',
      severity: 'error',
      from: { path: '^drivers/([^/]+)/' },
      to: {
        path: '^drivers/([^/]+)/',
        pathNot: '^drivers/$1/',
      },
    },
    {
      name: 'no-orphans',
      comment: 'Modules without any incoming or outgoing dependencies are usually dead code.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)tsconfig\\.[^/]+\\.json$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|localdocs|\\.homeybuild|coverage|test)/' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
