import { defineConfig } from 'vite';

export default defineConfig({
  // 저장소 이름으로 base 설정 (깃허브 페이지용)
  base: '/mynote/',
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const norm = id.replace(/\\/g, '/');
          if (norm.includes('@firebase/storage') || norm.includes('firebase/storage')) {
            return undefined;
          }
          if (norm.includes('node_modules/firebase') || norm.includes('node_modules/@firebase')) {
            return 'firebase-vendor';
          }
          if (norm.includes('node_modules/katex')) {
            return 'katex-vendor';
          }
          if (norm.includes('node_modules/marked') || norm.includes('node_modules/dompurify')) {
            return 'markdown-vendor';
          }
        }
      }
    }
  }
});
