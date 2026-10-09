package secure

import (
	"bytes"
	"testing"
)

func TestBoxRoundTrip(t *testing.T) {
	b, err := NewBox(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	enc, err := b.Encrypt("app-secret")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte("app-secret")) {
		t.Fatal("plaintext leaked into ciphertext")
	}
	got, err := b.Decrypt(enc)
	if err != nil || got != "app-secret" {
		t.Fatalf("decrypt: %q %v", got, err)
	}
	other, _ := NewBox(bytes.Repeat([]byte{2}, 32))
	if _, err := other.Decrypt(enc); err == nil {
		t.Fatal("decrypted with the wrong key")
	}
}

func TestPasswordHash(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse battery", h) || VerifyPassword("wrong", h) {
		t.Fatal("verify mismatch")
	}
}

func TestMask(t *testing.T) {
	if m := Mask("sk-1234567890"); m == "sk-1234567890" || len(m) < 4 {
		t.Fatalf("mask: %s", m)
	}
}
