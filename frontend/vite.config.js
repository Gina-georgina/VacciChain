import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']

function isLocalhostUrl(value) {
  if (!value) return true
  try {
    const url = new URL(value)
    return LOCAL_HOSTNAMES.includes(url.hostname)
  } catch {
    return true
  }
}

function validateProductionEnv(env) {
  const errors = []

  const apiBaseUrl = env.VITE_API_BASE_URL
  if (!apiBaseUrl) {
    errors.push('VITE_API_BASE_URL is not set.')
  } else if (isLocalhostUrl(apiBaseUrl)) {
    errors.push(
      `VITE_API_BASE_URL resolves to localhost ("${apiBaseUrl}"); production builds must target a real API endpoint.`,
    )
  }

  const analyticsBaseUrl = env.VITE_ANALYTICS_BASE_URL
  if (!analyticsBaseUrl) {
    errors.push('VITE_ANALYTICS_BASE_URL is not set.')
  } else if (isLocalhostUrl(analyticsBaseUrl)) {
    errors.push(
      `VITE_ANALYTICS_BASE_URL resolves to localhost ("${analyticsBaseUrl}"); production builds must target a real analytics endpoint.`,
    )
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid production configuration:\n  - ${errors.join('\n  - ')}\n` +
        'Set VITE_API_BASE_URL and VITE_ANALYTICS_BASE_URL to usable endpoints before building for production.',
    )
  }
}

function productionConfigCheck() {
  let isProductionBuild = false
  let env = {}

  return {
    name: 'validate-production-config',
    apply: 'build',
    configResolved(config) {
      isProductionBuild = config.mode === 'production'
    },
    config(_, { mode }) {
      env = loadEnv(mode, process.cwd(), '')
    },
    buildStart() {
      if (isProductionBuild) {
        validateProductionEnv(env)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), productionConfigCheck()],

  server: {
    port: 3000,
    proxy: {
      '/auth': 'http://backend:4000',
      '/vaccination': 'http://backend:4000',
      '/verify': 'http://backend:4000',
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