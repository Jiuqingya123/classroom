/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** 构建时注入的默认服务端地址，来自 apps/desktop/.env.production */
  readonly MAIN_VITE_SERVER_URL?: string;
}
