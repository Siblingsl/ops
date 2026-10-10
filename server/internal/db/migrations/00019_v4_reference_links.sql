-- +goose Up
CREATE TABLE account_reference (
    account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
    reference_id uuid NOT NULL REFERENCES reference_item(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, reference_id)
);
CREATE INDEX account_reference_ref_idx ON account_reference(reference_id);
INSERT INTO account_reference(account_id, reference_id) SELECT account_id, id FROM reference_item;

-- +goose Down
DROP TABLE account_reference;
