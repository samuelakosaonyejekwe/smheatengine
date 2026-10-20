// Shared physical property models used across suites (single source of truth for consistency).
import { G0, R_AIR, R_V, SIGMA, KELVIN, rad, deg, clamp } from './num.js';

// ---------------- Atmosphere ----------------
// Saturation vapour pressure over water (Buck 1996), Pa; T in °C
export const psat = (Tc) => 611.21 * Math.exp((18.678 - Tc / 234.5) * (Tc / (257.14 + Tc)));
export const dewPoint = (Tc, RH) => { const g = Math.log(Math.max(1e-6, RH / 100)) + 17.62 * Tc / (243.12 + Tc); return 243.12 * g / (17.62 - g); };
// Moist-air density (Dalton partial pressures), p in Pa, T °C, RH %
export function moistAir(p, Tc, RH) {
  const T = Tc + KELVIN, pv = clamp(RH, 0, 100) / 100 * psat(Tc), pd = p - pv;
  const rho = pd / (R_AIR * T) + pv / (R_V * T);
  const w = 0.62198 * pv / Math.max(1, p - pv); // mixing ratio kg/kg
  const q = w / (1 + w);                        // specific humidity
  const Tv = T * (1 + 0.6078 * q);              // virtual temperature
  const mu = 1.458e-6 * T ** 1.5 / (T + 110.4); // Sutherland dynamic viscosity
  const k = 2.64638e-3 * T ** 1.5 / (T + 245.4 * 10 ** (-12 / T)); // air conductivity
  return { rho, pv, pd, w, q, Tv, mu, nu: mu / rho, k, cp: 1005 + 1860 * q, Pr: 0.71 };
}
// ISA standard atmosphere (troposphere/lower stratosphere)
export function isa(h) {
  if (h < 11000) { const T = 288.15 - 0.0065 * h, p = 101325 * (T / 288.15) ** 5.25588; return { T, p, rho: p / (R_AIR * T) }; }
  const T = 216.65, p = 22632.06 * Math.exp(-G0 * (h - 11000) / (R_AIR * T)); return { T, p, rho: p / (R_AIR * T) };
}
// Hypsometric reduction of surface pressure to another height, T mean virtual K
export const hypsometric = (p0, dz, TvK) => p0 * Math.exp(-G0 * dz / (R_AIR * TvK));
// Wind profiles
export const logWind = (Uref, zref, z, z0, psiRef = 0, psiZ = 0) => Uref * (Math.log(z / z0) - psiZ) / (Math.log(zref / z0) - psiRef);
export const powerWind = (Uref, zref, z, alpha) => Uref * (z / zref) ** alpha;
// Businger–Dyer stability corrections; L Obukhov length
export function psiM(z, L) { if (!L || !Number.isFinite(L)) return 0; const zeta = z / L; if (zeta >= 0) return -5 * zeta; const x = (1 - 16 * zeta) ** 0.25; return 2 * Math.log((1 + x) / 2) + Math.log((1 + x * x) / 2) - 2 * Math.atan(x) + Math.PI / 2; }
export const ROUGHNESS = { 'open water': 0.0002, 'mud flats / snow': 0.005, 'short grass / airfield': 0.03, 'farmland, few hedges': 0.1, 'farmland, many hedges': 0.25, 'suburb / forest edge': 0.5, 'town / forest': 1.0, 'city centre': 2.0 };
// Turbulence spectra (normalised) – Kaimal and von Kármán longitudinal, f Hz
export const kaimal = (f, U, sigma, L = 340.2) => sigma ** 2 * 4 * L / U / (1 + 6 * f * L / U) ** (5 / 3);
export const vonKarman = (f, U, sigma, L = 340.2) => sigma ** 2 * 4 * L / U / (1 + 70.8 * (f * L / U) ** 2) ** (5 / 6);
// 1-cosine discrete gust
export const oneMinusCos = (t, t0, dur, Ug) => (t < t0 || t > t0 + dur) ? 0 : 0.5 * Ug * (1 - Math.cos(2 * Math.PI * (t - t0) / dur));

// ---------------- Solar geometry (NOAA general solar position algorithm) ----------------
export function solarPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5, jc = (jd - 2451545) / 36525;
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360, M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C, omega = 125.04 - 1934.136 * jc, lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60, eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (minutes + eqTime + 4 * lon + 1440) % 1440, ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const cosZ = Math.sin(rad(lat)) * Math.sin(rad(decl)) + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha));
  const zenith = deg(Math.acos(clamp(cosZ, -1, 1)));
  let az = deg(Math.acos(clamp((Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(decl))) / (Math.cos(rad(lat)) * Math.sin(rad(zenith)) || 1e-9), -1, 1)));
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  const doy = Math.floor((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 0))) / 86400000);
  const E0 = 1361 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365)); // extraterrestrial normal irradiance
  return { zenith, elevation: 90 - zenith, azimuth: az, declination: decl, eqTime, E0, hourAngle: ha };
}
// Clear-sky irradiance (Ineichen–Perez simplified with Linke turbidity TL)
export function clearSky(zenithDeg, altitude = 0, TL = 3) {
  if (zenithDeg >= 90) return { ghi: 0, dni: 0, dhi: 0 };
  const cz = Math.cos(rad(zenithDeg)), am = 1 / (cz + 0.50572 * (96.07995 - zenithDeg) ** -1.6364), fh1 = Math.exp(-altitude / 8000), fh2 = Math.exp(-altitude / 1250);
  const cg1 = 5.09e-5 * altitude + 0.868, cg2 = 3.92e-5 * altitude + 0.0387, I0 = 1361;
  const ghi = Math.max(0, cg1 * I0 * cz * Math.exp(-cg2 * am * (fh1 + fh2 * (TL - 1))) * Math.exp(0.01 * am ** 1.8));
  const b = 0.664 + 0.163 / fh1, dni = Math.max(0, Math.min(b * I0 * Math.exp(-0.09 * am * (TL - 1)), (ghi / cz)));
  return { ghi, dni, dhi: Math.max(0, ghi - dni * cz) };
}
// Effective clear-sky emissivity models; Tdp dew point °C, Ta air K
export const skyEmissivity = {
  'Berdahl–Martin': (Ta, Tdp) => 0.711 + 0.56 * (Tdp / 100) + 0.73 * (Tdp / 100) ** 2,
  'Swinbank': (Ta) => 9.365e-6 * Ta ** 2,
  'Brunt': (Ta, Tdp) => 0.52 + 0.065 * Math.sqrt(psat(Tdp) / 100),
  'Idso–Jackson': (Ta) => 1 - 0.261 * Math.exp(-7.77e-4 * (Ta - 273.15) ** 2),
};
// Cloud correction (Crawford–Duchon style): eps_all = eps_clr*(1-c) + c
export const cloudyEmissivity = (epsClr, cloudFrac) => epsClr * (1 - clamp(cloudFrac, 0, 1)) + clamp(cloudFrac, 0, 1);
export const skyTemperature = (TaK, eps) => TaK * eps ** 0.25;
export const longwaveDown = (TaK, eps) => eps * SIGMA * TaK ** 4;

// ---------------- Thermodynamics ----------------
export const carnot = (Th, Tc) => Th > Tc ? 1 - Tc / Th : 0;
export const curzonAhlborn = (Th, Tc) => Th > Tc ? 1 - Math.sqrt(Tc / Th) : 0;
// Exergy of a heat flow Q at temperature T relative to dead state T0
export const heatExergy = (Q, T, T0) => Q * (1 - T0 / T);
export const planck = (lambda_m, T) => (2 * 6.62607015e-34 * 299792458 ** 2) / (lambda_m ** 5 * (Math.exp(6.62607015e-34 * 299792458 / (lambda_m * 1.380649e-23 * T)) - 1));

// ---------------- Convection correlations ----------------
export function flatPlateH(U, L, air) { const Re = U * L / air.nu; const Nu = Re < 5e5 ? 0.664 * Re ** 0.5 * air.Pr ** (1 / 3) : (0.037 * Re ** 0.8 - 871) * air.Pr ** (1 / 3); return { Re, Nu, h: Math.max(0, Nu) * air.k / L }; }
export function naturalConvH(dT, L, air, Tfilm) { const beta = 1 / Tfilm, Gr = G0 * beta * Math.abs(dT) * L ** 3 / air.nu ** 2, Ra = Gr * air.Pr; const Nu = Ra < 1e7 ? 0.54 * Ra ** 0.25 : 0.15 * Ra ** (1 / 3); return { Gr, Ra, Nu, h: Nu * air.k / L }; }
export const STATUS = { ok: 'pass', warn: 'warn', fail: 'fail' };
