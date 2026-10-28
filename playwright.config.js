// Автотесты Liquid (tests/). Один браузер на все тесты, по порядку — как человек, который им пользуется.
module.exports = {
  testDir: 'tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
};
