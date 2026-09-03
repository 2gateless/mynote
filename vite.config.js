import { defineConfig } from 'vite';

export default defineConfig({
  // 저장소 이름으로 base 설정 (깃허브 페이지용)
  base: '/mynote/',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase')) {
            return 'firebase-vendor';
          }
          if (id.includes('node_modules/marked') || id.includes('node_modules/dompurify')) {
            return 'markdown-vendor';
          }
        }
      }
    }
  }
});
