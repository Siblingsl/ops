// Package cxrendercontract contains metadata only for deployed renderer
// resources. Markup and CSS remain in the independent Web and desktop apps.
package cxrendercontract

const WechatHTMLV1 = "ops.wechat-html/v1"

type ThemeResource struct {
	Version     int
	TokenDigest string
}

var builtinThemes = map[string]ThemeResource{
	"simple":    {Version: 1, TokenDigest: "cb72c1749096c2c2eff4ab7c7e5193e4b8eede9fb52f1ecb8dde88f2ff840e7d"},
	"ink":       {Version: 1, TokenDigest: "7cdbe17ec5506ecc6107160e14064eeb2135f4111d870ebbb5224b1f52fdb695"},
	"tenghuang": {Version: 2, TokenDigest: "03f0d3a8cfeaf50c054283bdce4999da0ae941cd26c5d1c80307f3aec329b8d8"},
	"mobai":     {Version: 1, TokenDigest: "ce8b0d67200129b8c489230c5b74745aa4548e7c397ee359603c9dd275f25b2f"},
	"olive":     {Version: 1, TokenDigest: "7a127e42353b74b89e0e61c367c3a538bcf6ec840569f3395a90b7c40ae9e1df"},
	"sage":      {Version: 1, TokenDigest: "dc914108c78aa1590e4bddcb3f9ad8161b73b12a879158f1f463ffb3b1822685"},
	"redwhite":  {Version: 1, TokenDigest: "ea3a10bbdceecc41edb7f8e3cee25cd4d70c6f0614fc9781e20d6cffbd126f4b"},
	"graphite":  {Version: 1, TokenDigest: "326a1e71f337e1f76a944720bc835013c6afeabc8370018c2aa7478f0a31082c"},
}

func SupportsWechatHTML(version string) bool {
	return version == WechatHTMLV1
}

func BuiltinTheme(id string) (ThemeResource, bool) {
	resource, ok := builtinThemes[id]
	return resource, ok
}
