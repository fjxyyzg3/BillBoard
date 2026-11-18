import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: [".next/**", ".worktrees/**", ".agents/**", ".claude/**", "coverage/**", "node_modules/**", "playwright-report/**", "test-results/**", "tmp/**", "android/**/build/**", "android/.gradle/**", "desktop/build/**", "desktop/dist/**", "desktop/shared/**"],
  },
  ...nextVitals,
];

export default config;
