/** Product UI examples. See scripts/capture-product-ui-provenance.md for source and limits. */
export const CAPTURES = {
  takos: {
    desktop: { src: "/screens/takos-app-desktop.png", width: 1800, height: 1120 },
    mobile: { src: "/screens/takos-app-mobile.png", width: 780, height: 1240 },
    dark: {
      desktop: { src: "/screens/takos-app-dark-desktop.png", width: 1800, height: 1120 },
      mobile: { src: "/screens/takos-app-dark-mobile.png", width: 780, height: 1240 },
    },
  },
  yurucommu: {
    desktop: { src: "/screens/yurucommu-desktop.webp", width: 1280, height: 720 },
    mobile: { src: "/screens/yurucommu-mobile.webp", width: 780, height: 1688 },
  },
  office: {
    desktop: { src: "/screens/office-app-desktop.png", width: 2000, height: 1360 },
    mobile: { src: "/screens/office-app-mobile.png", width: 780, height: 1240 },
    dark: {
      desktop: { src: "/screens/office-app-dark-desktop.png", width: 2000, height: 1360 },
      mobile: { src: "/screens/office-app-dark-mobile.png", width: 780, height: 1240 },
    },
  },
} as const;

/** Actual Takosumi dashboard views with browser-served public examples. */
export const DASHBOARD_CAPTURES = {
  home: {
    desktop: { src: "/screens/dashboard-home-desktop.png", width: 2400, height: 880 },
    mobile: { src: "/screens/dashboard-home-mobile.png", width: 780, height: 1400 },
    desktopLight: { src: "/screens/dashboard-home-desktop-light.png", width: 2400, height: 880 },
    mobileLight: { src: "/screens/dashboard-home-mobile-light.png", width: 780, height: 1400 },
  },
  install: {
    desktop: { src: "/screens/dashboard-install-desktop.png", width: 2400, height: 1500 },
    mobile: { src: "/screens/dashboard-install-mobile.png", width: 780, height: 1900 },
    desktopLight: { src: "/screens/dashboard-install-desktop-light.png", width: 2400, height: 1500 },
    mobileLight: { src: "/screens/dashboard-install-mobile-light.png", width: 780, height: 1900 },
  },
} as const;
