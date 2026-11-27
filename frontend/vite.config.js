import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // The manifest feeds scripts/bundle-report.mjs.
  build: { manifest: true },

  server: {
    port: 3000,
    proxy: {
      '/v1': 'http://backend:4000',
      '/auth': 'http://backend:4000',
      '/vaccination': 'http://backend:4000',
      '/analytics/': 'http://python-service:8001',
      '/verify': 'http://backend:4000',
      '/analytics': 'http://python-service:8001',
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('pages/Landing')) return 'route-landing';
          if (id.includes('pages/PatientDashboard')) return 'route-patient';
          if (id.includes('pages/IssuerDashboard')) return 'route-issuer';
          if (id.includes('pages/VerifyPage')) return 'route-verify';
          if (id.includes('pages/AdminDashboard')) return 'route-admin';
          if (id.includes('pages/IssuerOnboarding')) return 'route-onboarding';
          if (id.includes('pages/AnalyticsDashboard')) return 'route-analytics';
          if (id.includes('react-router-dom')) return 'vendor-router';
          if (id.includes('react') || id.includes('react-dom')) return 'vendor-react';
          if (id.includes('i18next') || id.includes('react-i18next')) return 'vendor-i18n';
          if (id.includes('jspdf') || id.includes('qrcode')) return 'vendor-certificate';
        },
      },
    },
  },

  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text-summary'],
      include: ['src/**/*.{js,jsx}'],
      thresholds: {
        lines: 70,
      },
    },
  },
})
