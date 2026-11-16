export const MIN_CURRENT_AMPS = 6;
export const MAX_SUPPORTED_AMPS = 48;

function wholeAmps(value) {
  return Number.isInteger(value) && value >= MIN_CURRENT_AMPS && value <= MAX_SUPPORTED_AMPS;
}

// `/config` is the authority for whether current control is safe to expose.
// The soft limit is the ordinary operating ceiling; the hard limit only
// validates that ceiling, and pilot remains a separate setpoint used for the
// initial slider value. Any incomplete or contradictory view fails closed.
export function currentCapability(config) {
  if (!config || typeof config !== 'object') return null;
  const soft = config.max_current_soft;
  const hard = config.max_current_hard;
  const pilot = config.pilot;
  if (!wholeAmps(soft) || !wholeAmps(hard) || !wholeAmps(pilot)) return null;
  if (soft > hard || pilot > hard) return null;
  return { min: MIN_CURRENT_AMPS, max: soft, hard, pilot };
}
