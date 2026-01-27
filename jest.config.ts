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
    "<rootDir>/src/apps/crc-backers/logic.ts",
    "<rootDir>/src/apps/gnosis-group/logic.ts",
    "<rootDir>/src/apps/oic/logic.ts",
    "<rootDir>/src/apps/gp-crc/logic.ts",
    "<rootDir>/src/apps/router-tms/logic.ts",
    "<rootDir>/fakes/fakes.ts",
    "!<rootDir>/src/main.ts",
    "!**/*.d.ts",
    "!**/__tests__/**",
    "!<rootDir>/tests/**"
  ],
  coverageReporters: ["text", "lcov", "html"],

  transform: {
    "^.+\\.tsx?$": ["ts-jest", {tsconfig: "<rootDir>/tsconfig.json"}]
  }
};
