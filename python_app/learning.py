from __future__ import annotations


def calibrate_partner_probability(
    base_score: float,
    *,
    resolved: float = 0,
    accepted: float = 0,
    explicit_rejections: float = 0,
    prior_strength: float = 8,
) -> int:
    """Personalize a feasibility score with an empirical-Bayes update.

    The rules engine supplies an explainable prior from market, lineup, roster,
    urgency, and transaction-history features. Observed journal outcomes update
    that prior gradually. A meaningful prior sample prevents a single accepted
    or rejected offer from making the model overconfident.
    """
    probability = max(.01, min(.99, float(base_score) / 100))
    resolved = max(0.0, float(resolved))
    accepted = max(0.0, min(resolved, float(accepted)))
    # Explicit "partner would not accept" feedback is weaker than an actual
    # rejected offer and therefore counts as a quarter-observation.
    weak_rejections = max(0.0, float(explicit_rejections)) * .25
    posterior = (
        probability * prior_strength + accepted
    ) / max(prior_strength + resolved + weak_rejections, 1)
    # Personal history is a calibration layer, never the whole prediction.
    # These asymmetric bounds reflect that acceptance is noisy while repeated
    # rejection is somewhat stronger evidence that an offer style misses.
    calibrated = max(base_score - 11, min(base_score + 8, posterior * 100))
    return round(max(0, min(100, calibrated)))
