/* 链路自测：在 Node 里桩掉 window/localStorage，验证动态储备与物资-火情-队伍调用链规则。
 * 运行：npm run chain-check
 */
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')

function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

globalThis.window = {
  localStorage: makeLocalStorage(),
  dispatchEvent: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.localStorage = globalThis.window.localStorage

const entry = path.join(__dirname, 'chain-check.ts')
const outfile = path.join(__dirname, 'chain-check.bundle.cjs')

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    alias: { '@': path.join(root, 'src') },
    logLevel: 'silent',
  })
  .then(() => {
    require(outfile)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
