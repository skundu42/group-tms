/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",

  rootDir: __dirname,
  roots: ["<rootDir>"],
  testMatch: ["<rootDir>/tests/**/*.spec.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/setupTests.ts"],

  collectCoverage: true,
  collectCoverageFrom: [
    "<rootDir>/src/**/*.ts",
    "!<rootDir>/src/main.ts",
    "!<rootDir>/src/abi/**",
    "!**/*.d.ts",
    "!**/__tests__/**",
    "!<rootDir>/tests/**"
  ],
  coverageReporters: ["text", "lcov", "html"],

  transform: {
    "^.+\\.tsx?$": ["ts-jest", {tsconfig: "<rootDir>/tsconfig.json"}]
  }
};
