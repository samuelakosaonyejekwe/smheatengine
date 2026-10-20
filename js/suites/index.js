// Registry of the 22 THERMA-X100 research-platform suites (lazy-loaded modules). Numbering follows the master
// specification §25 "Complete 22-module research platform register".
const G1 = 'System definition, geometry & active materials', G2 = 'Thermal supply, rejection, heat transfer & regeneration', G3 = 'Transmission, scheduling, fluids, coupling & dynamics', G4 = 'Durability, optimisation, thermodynamics & evidence', G5 = 'Manufacturing, safety & economics';
const S = (num, short, title, group, icon, file) => ({ id: 's' + String(num).padStart(2, '0'), num, short, title, group, icon, load: () => import(`./${file}.js`) });
export const SUITES = [
  S(1, 'Architecture', 'Engine architecture and system requirement management', G1, '🏛', 's01-architecture'),
  S(2, 'CAD & meshing', '2-D/3-D parametric CAD and computational meshing', G1, '📐', 's02-cad-mesh'),
  S(3, 'Materials', 'Materials library and alloy characterization', G1, '🧪', 's03-materials'),
  S(4, 'Phase transformation', 'Phase transformation and SMA microstructure', G1, '🔬', 's04-phase'),
  S(5, 'Cartridge', 'SMA ribbon and thermal-muscle cartridge design', G1, '🧵', 's05-cartridge'),
  S(6, 'Hot source', 'Hot-source conditioning and thermal supply', G2, '🔥', 's06-hot-source'),
  S(7, 'Cold sink', 'Cold sink and heat rejection', G2, '❄', 's07-cold-sink'),
  S(8, 'Microchannels', 'Microchannels, contacts and transient heat transfer', G2, '〰', 's08-microchannels'),
  S(9, 'Regenerator', 'Regenerator and thermal storage', G2, '♻', 's09-regenerator'),
  S(10, 'Metamaterial', 'Mechanical metamaterial and compliant transmission', G3, '⬡', 's10-metamaterial'),
  S(11, 'Shaft & torque', 'Shaft coupling and torque transmission', G3, '⚙', 's11-shaft'),
  S(12, 'Phase timing', 'Multicell phase timing and load scheduling', G3, '⏱', 's12-timing'),
  S(13, 'Hydraulics', 'Hydraulic distribution, valves and fluid auxiliaries', G3, '🚰', 's13-hydraulics'),
  S(14, 'Co-simulation', 'Integrated thermal-fluid-structural co-simulation', G3, '🔁', 's14-cosim'),
  S(15, 'Start-up & dynamics', 'Startup, shutdown and off-design dynamics', G3, '🚦', 's15-dynamics'),
  S(16, 'Fatigue & integrity', 'Structural integrity, creep, fatigue and failure', G4, '🛡', 's16-fatigue'),
  S(17, 'Optimisation & UQ', 'Optimization, inverse design and uncertainty', G4, '🎯', 's17-optimisation'),
  S(18, 'Thermodynamics', 'Thermodynamic accounting, efficiency and exergy', G4, '🌡', 's18-thermodynamics'),
  S(19, 'Experiments & twin', 'Experimental management, calibration and digital twin', G4, '🧾', 's19-twin'),
  S(20, 'Manufacturing', 'Manufacturing, metrology and assembly', G5, '🏭', 's20-manufacturing'),
  S(21, 'Safety & control', 'Safety, reliability and operational control', G5, '🚨', 's21-safety'),
  S(22, 'Techno-economics', 'Techno-economics, scalability and lifecycle', G5, '💹', 's22-economics'),
];
export const GROUPS = [G1, G2, G3, G4, G5];
export const suiteIndex = (id) => SUITES.findIndex(s => s.id === id);
