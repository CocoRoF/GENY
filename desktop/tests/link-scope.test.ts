/**
 * link-scope — TransportScope 매핑의 단위 검증.
 *
 * 연결 폴더(remotePrefix)와 드라이브 보호(excludePrefixes)는 전부
 * HttpSyncTransport 한 곳에서 매핑된다. 여기서 깨지면 "한 경로 한 엔진"
 * 불변식이 무너지므로(이중 업로드/유령 삭제) fetch를 스텁으로 갈아끼워
 * 요청 URL과 changes 필터링을 직접 검증한다.
 */
import assert from 'assert'
import { HttpSyncTransport } from '../src/main/sync-transport'

const AUTH = {
  baseUrl: 'http://x',
  token: async () => 't',
  sessionId: 'sid',
  deviceId: 'dev',
}

function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = orig
  })
}

async function main(): Promise<void> {
  // 1) remotePrefix: outgoing paths are re-based under workspace/<prefix>/
  {
    const t = new HttpSyncTransport(AUTH, '/tmp/x', { scope: { remotePrefix: 'myproj' } })
    let seen = ''
    await withFetch(
      async (url) => {
        seen = url
        return new Response('{}', { status: 200 })
      },
      async () => {
        await t.mkdir('sub/dir')
      },
    )
    assert(
      decodeURIComponent(seen).includes('path=workspace/myproj/sub/dir'),
      `mkdir must target the subtree, got ${seen}`,
    )
  }

  // 2) remotePrefix: changes feed filtered to the subtree and re-based;
  //    the prefix directory itself disappears (engine root always exists);
  //    latest_seq passes through untouched.
  {
    const t = new HttpSyncTransport(AUTH, '/tmp/x', { scope: { remotePrefix: 'myproj' } })
    const payload = {
      latest_seq: 42,
      stale_cursor: false,
      changes: [
        { path: 'myproj', is_dir: true, size: 0, sha256: '', seq: 1, deleted: false },
        { path: 'myproj/a.txt', is_dir: false, size: 3, sha256: 'aa', seq: 2, deleted: false },
        { path: 'myproj/deep/b.txt', is_dir: false, size: 3, sha256: 'bb', seq: 3, deleted: false },
        { path: 'myproj2/other.txt', is_dir: false, size: 3, sha256: 'cc', seq: 4, deleted: false },
        { path: 'other.txt', is_dir: false, size: 3, sha256: 'dd', seq: 5, deleted: false },
      ],
    }
    await withFetch(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
      async () => {
        const r = await t.changes(0)
        assert.strictEqual(r.latest_seq, 42)
        assert.deepStrictEqual(
          r.changes.map((c) => c.path),
          ['a.txt', 'deep/b.txt'],
          '유사 접두사(myproj2)는 절대 포함되면 안 된다',
        )
      },
    )
  }

  // 3) excludePrefixes: the drive pair never sees linked subtrees —
  //    including the subtree ROOT dir entry (downloading it would
  //    materialize a real dir where the shortcut symlink belongs).
  {
    const t = new HttpSyncTransport(AUTH, '/tmp/x', { scope: { excludePrefixes: ['myproj'] } })
    const payload = {
      latest_seq: 9,
      stale_cursor: false,
      changes: [
        { path: 'myproj', is_dir: true, size: 0, sha256: '', seq: 1, deleted: false },
        { path: 'myproj/a.txt', is_dir: false, size: 3, sha256: 'aa', seq: 2, deleted: false },
        { path: 'myproj2/keep.txt', is_dir: false, size: 3, sha256: 'cc', seq: 3, deleted: false },
        { path: 'root.txt', is_dir: false, size: 3, sha256: 'dd', seq: 4, deleted: false },
      ],
    }
    await withFetch(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
      async () => {
        const r = await t.changes(0)
        assert.deepStrictEqual(
          r.changes.map((c) => c.path),
          ['myproj2/keep.txt', 'root.txt'],
        )
      },
    )
  }

  // 4) no scope → passthrough, zero behavioral change for drive pairs
  //    without links (the overwhelmingly common case).
  {
    const t = new HttpSyncTransport(AUTH, '/tmp/x')
    let seen = ''
    await withFetch(
      async (url) => {
        seen = url
        return new Response('{}', { status: 200 })
      },
      async () => {
        await t.mkdir('plain/dir')
      },
    )
    assert(decodeURIComponent(seen).includes('path=workspace/plain/dir'), seen)
  }

  console.log('ALL LINK-SCOPE TESTS PASS (4)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
