-- +goose Up
-- D-122 CL-06: checks remember only the digest of the material basis used.
ALTER TABLE check_run
  ADD COLUMN material_basis_hash text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE check_run
  DROP COLUMN material_basis_hash;
