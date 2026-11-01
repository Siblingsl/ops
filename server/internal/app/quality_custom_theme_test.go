package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestCustomThemeValidatePrimaryColorContrast(t *testing.T) {
	base := CustomTheme{
		Base:         "ink",
		PrimaryColor: "#2F5D62",
		FontSize:     16,
		LineHeight:   1.8,
		ParagraphGap: 18,
		HeadingStyle: "underline",
		QuoteStyle:   "bar",
	}

	tests := []struct {
		name    string
		color   string
		wantErr bool
	}{
		{name: "accessible color", color: "#2F5D62"},
		{name: "threshold color", color: "#767676"},
		{name: "low contrast historical value cannot be resaved", color: "#999999", wantErr: true},
		{name: "invalid CSS color", color: "rgba(0,0,0,.5)", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			theme := base
			theme.PrimaryColor = tt.color
			err := theme.validate()
			if (err != nil) != tt.wantErr {
				t.Fatalf("validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestCustomThemeAPIRejectsLowContrastWriteAndKeepsLegacyReadable(t *testing.T) {
	account := env.accounts(t).wechat
	path := "/api/v1/accounts/" + account.ID.String() + "/custom-theme"
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `UPDATE account_profile SET custom_theme=NULL WHERE account_id=$1`, account.ID)
	})

	legacy := CustomTheme{
		Base:         "ink",
		PrimaryColor: "#999999",
		FontSize:     16,
		LineHeight:   1.8,
		ParagraphGap: 18,
		HeadingStyle: "underline",
		QuoteStyle:   "bar",
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE account_profile SET custom_theme=$2, updated_at=now() WHERE account_id=$1`, account.ID, raw); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := env.srv.db.QueryRow(context.Background(), `SELECT updated_at FROM account_profile WHERE account_id=$1`, account.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	var got CustomTheme
	env.mustJSON(t, "GET", path, nil, &got)
	if got.PrimaryColor != legacy.PrimaryColor {
		t.Fatalf("GET returned primary color %q, want legacy value %q", got.PrimaryColor, legacy.PrimaryColor)
	}
	var after time.Time
	if err := env.srv.db.QueryRow(context.Background(), `SELECT updated_at FROM account_profile WHERE account_id=$1`, account.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(before) {
		t.Fatal("GET custom-theme unexpectedly changed updated_at")
	}

	env.expectErr(t, "PUT", path, legacy, "validation_failed")
	legacy.PrimaryColor = "#2F5D62"
	env.mustJSON(t, "PUT", path, legacy, nil)
}
