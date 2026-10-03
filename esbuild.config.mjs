import esbuild from 'esbuild';

const production = process.argv.includes('production');
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  platform: 'browser',
  // mime-types also uses path internally. Bundle the POSIX browser replacement.
  alias: { path: 'path-browserify' },
  format: 'cjs',
  target: 'es2022',
  // crypto is only the SDK's unused webhook fallback, not a sync dependency.
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', 'crypto'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
