/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/lib', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react-jsx',
      },
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/**/index.ts',
    // Absorbed charting engine — covered by its own vitest suite.
    '!lib/charting/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    'lib/trading/symbol-settings.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    'lib/market/feed-normalize.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  moduleNameMapper: {
    // The charting engine lives at lib/charting; jest stubs it wholesale so
    // component tests never touch the real renderer/DOM/WebSockets. These
    // entries must precede the `^@/(.*)$` catch-all.
    '^@/lib/charting/data/providers/binance$': '<rootDir>/__mocks__/vela-providers-binance.js',
    '^@/lib/charting$': '<rootDir>/__mocks__/vela.js',
    '^@/(.*)$': '<rootDir>/$1',
    '^server-only$': '<rootDir>/__mocks__/server-only.js',
  },
  testPathIgnorePatterns: ['/node_modules/', '/.next/', '/tests/integration/', '/lib/charting/'],
  setupFiles: ['<rootDir>/tests/jest.setup.ts'],
};
