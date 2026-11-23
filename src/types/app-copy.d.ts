// The app's Drive client (src/records/app/drive.ts, a pinned copy) is written
// for browsers and passes `referrerPolicy`; src/records/drive-source.ts drops
// it before the request leaves. This lets the copy typecheck unchanged.
export {};

declare global {
  interface RequestInit<Cf = CfProperties> {
    referrerPolicy?: string;
  }
}
