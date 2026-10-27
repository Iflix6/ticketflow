-- Rollback of 0007.
DROP TABLE IF EXISTS reconciliation_findings;
DROP TABLE IF EXISTS experiment_results;
DROP TRIGGER IF EXISTS experiment_runs_enforce_immutability ON experiment_runs;
DROP FUNCTION IF EXISTS app.experiment_runs_enforce_immutability();
DROP TABLE IF EXISTS experiment_runs;
