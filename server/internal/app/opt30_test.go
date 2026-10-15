package app

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func opt30PNGHeader(width, height uint32) []byte {
	data := make([]byte, 13)
	binary.BigEndian.PutUint32(data[0:4], width)
	binary.BigEndian.PutUint32(data[4:8], height)
	data[8], data[9] = 8, 2
	var out bytes.Buffer
	out.Write([]byte("\x89PNG\r\n\x1a\n"))
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	out.Write(length[:])
	out.WriteString("IHDR")
	out.Write(data)
	checksum := crc32.ChecksumIEEE(append([]byte("IHDR"), data...))
	binary.BigEndian.PutUint32(length[:], checksum)
	out.Write(length[:])
	return out.Bytes()
}

func TestOPT30OversizedUploadRejectedBeforeDecodeUnder50MB(t *testing.T) {
	f := env.accounts(t)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "OPT30 超大图拒绝"}, &work)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	file, err := mw.CreateFormFile("file", "oversized.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(opt30PNGHeader(20_000, 20_000)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	resp := env.request("POST", "/api/v1/works/"+work.ID.String()+"/assets", &body, mw.FormDataContentType())
	response, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if resp.StatusCode == http.StatusOK || !strings.Contains(string(response), "像素") {
		t.Fatalf("oversized PNG response = %d %s", resp.StatusCode, response)
	}
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("20000x20000 PNG rejected with %d bytes allocated", allocated)
	if allocated >= 50<<20 {
		t.Fatalf("oversized PNG allocated %d bytes, want <50MB", allocated)
	}
}

func TestOPT30UploadedThumbnailsAverageUnder50KB(t *testing.T) {
	f := env.accounts(t)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "OPT30 缩略图传输"}, &work)

	var total int64
	for i := 0; i < 5; i++ {
		asset := env.upload(t, work.ID.String(), testPNG(900+i*20, 500))
		ext := ".jpg"
		if asset.Mime == "image/png" {
			ext = ".png"
		}
		storagePath := filepath.Join("assets", work.ID.String(), asset.ID.String()+ext)
		for _, width := range []int{256, 512} {
			path := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(thumbnailStoragePath(storagePath, width, asset.Mime)))
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("upload did not create %dpx thumbnail: %v", width, err)
			}
		}
		if i == 0 {
			path := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(thumbnailStoragePath(storagePath, 256, asset.Mime)))
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}
		if i == 0 {
			resp := env.request("GET", asset.URL, nil, "")
			original, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || resp.StatusCode != http.StatusOK {
				t.Fatalf("original image response: status=%d err=%v", resp.StatusCode, err)
			}
			config, _, err := image.DecodeConfig(bytes.NewReader(original))
			if err != nil || config.Width != 900 {
				t.Fatalf("original image config: width=%d err=%v", config.Width, err)
			}
		}
		resp := env.request("GET", asset.URL+"?variant=256", nil, "")
		data, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("thumbnail response: status=%d err=%v", resp.StatusCode, err)
		}
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width != 256 {
			t.Fatalf("thumbnail config: width=%d err=%v", config.Width, err)
		}
		total += int64(len(data))
	}
	average := total / 5
	t.Logf("average 256px thumbnail transfer: %d bytes across 5 images", average)
	if average > 50<<10 {
		t.Fatalf("average 256px thumbnail = %d bytes, want <=50KB", average)
	}
}
