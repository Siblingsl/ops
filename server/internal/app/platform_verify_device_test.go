package app

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPlatformConnectionVerifyRequiresBoundDevice(t *testing.T) {
	for _, platform := range []string{"xhs", "wechat_mp"} {
		t.Run(platform, func(t *testing.T) {
			externalKey := "xhs_user_id:fixture-device-bound"
			if platform == "wechat_mp" {
				externalKey = "wechat_biz:fixture-device-bound"
			}
			f := newPlatformRunFixture(t, platform, externalKey)
			ctx := context.Background()
			if _, err := env.srv.db.Exec(ctx, `UPDATE platform_connection SET
				availability='verifying', last_verified_at=NULL, capabilities='{}'::jsonb,
				auto_collect=false, auto_adopt=false WHERE id=$1`, f.Connection); err != nil {
				t.Fatal(err)
			}

			publicKey, privateKey, err := ed25519.GenerateKey(nil)
			if err != nil {
				t.Fatal(err)
			}
			otherDevice := *f
			otherDevice.DeviceID = uuid.New()
			otherDevice.PrivateKey = privateKey
			if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_device
				(id,user_id,public_key,name,platform,version)
				VALUES ($1,$2,$3,'同一用户的另一台设备','windows-x64','1.0.0')`,
				otherDevice.DeviceID, f.UserID, []byte(publicKey)); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM desktop_device WHERE id=$1`, otherDevice.DeviceID)
			})

			// 请求体伪造绑定设备也不能替代设备证明中实际签名的设备。
			body, err := json.Marshal(map[string]any{
				"external_account_key": externalKey,
				"capabilities":         map[string]any{"adapterVersion": "device-proof-fixture"},
				"device_id":            f.DeviceID,
			})
			if err != nil {
				t.Fatal(err)
			}
			path := "/api/v1/desktop/platform/connections/" + f.Connection.String() + "/verify"
			status, response := otherDevice.signedPlatform(t, "platform.connection.verify", http.MethodPost, path, body)
			if status != http.StatusNotFound {
				t.Fatalf("同一用户的非绑定设备应被拒绝且不泄露连接，实际 %d %s", status, response)
			}
			var availability string
			var verifiedAt *time.Time
			var capabilities map[string]any
			if err := env.srv.db.QueryRow(ctx, `SELECT availability,last_verified_at,capabilities
				FROM platform_connection WHERE id=$1`, f.Connection).Scan(&availability, &verifiedAt, &capabilities); err != nil {
				t.Fatal(err)
			}
			if availability != "verifying" || verifiedAt != nil || len(capabilities) != 0 {
				t.Fatalf("拒绝其他设备后不得修改连接：availability=%s verified_at=%v capabilities=%v", availability, verifiedAt, capabilities)
			}
			var audits int
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log
				WHERE action='platform_connection_verify' AND target_id=$1`, f.Connection.String()).Scan(&audits); err != nil {
				t.Fatal(err)
			}
			if audits != 0 {
				t.Fatalf("拒绝其他设备后不得记录验证成功审计：%d", audits)
			}

			status, response = f.signedPlatform(t, "platform.connection.verify", http.MethodPost, path, body)
			if status != http.StatusOK {
				t.Fatalf("绑定设备应仍可验证连接：%d %s", status, response)
			}
			var connection platformConnection
			if err := json.Unmarshal(response, &connection); err != nil {
				t.Fatal(err)
			}
			if connection.ID != f.Connection || connection.Availability != "ready" || connection.LastVerifiedAt == nil || connection.AutoCollect || connection.AutoAdopt {
				t.Fatalf("绑定设备验证应保留归属且不自动开启采集或采用：%+v", connection)
			}
			var deviceID uuid.UUID
			if err := env.srv.db.QueryRow(ctx, `SELECT device_id FROM platform_connection WHERE id=$1`, f.Connection).Scan(&deviceID); err != nil {
				t.Fatal(err)
			}
			if deviceID != f.DeviceID {
				t.Fatalf("验证后应保持绑定设备：%s != %s", deviceID, f.DeviceID)
			}
		})
	}
}
