import unittest

from python_app.learning import calibrate_partner_probability


class PartnerLearningTests(unittest.TestCase):
    def test_no_history_preserves_explainable_prior(self) -> None:
        self.assertEqual(calibrate_partner_probability(64), 64)

    def test_acceptance_history_raises_probability_gradually(self) -> None:
        learned = calibrate_partner_probability(50, resolved=4, accepted=4)
        self.assertGreater(learned, 50)
        self.assertLess(learned, 100)

    def test_rejection_history_lowers_probability_gradually(self) -> None:
        learned = calibrate_partner_probability(70, resolved=4, accepted=0)
        self.assertLess(learned, 70)
        self.assertGreater(learned, 0)

    def test_feedback_is_weaker_than_observed_rejection(self) -> None:
        observed = calibrate_partner_probability(60, resolved=1, accepted=0)
        feedback = calibrate_partner_probability(60, explicit_rejections=1)
        self.assertLess(observed, feedback)


if __name__ == "__main__":
    unittest.main()
