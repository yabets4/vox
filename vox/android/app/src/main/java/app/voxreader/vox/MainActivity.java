package app.voxreader.vox;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        /* cross-origin isolation → SharedArrayBuffer → the voice model runs on several CPU cores
           instead of one (WASM threads). Every app file is same-origin; model downloads use CORS. */
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse res = super.shouldInterceptRequest(view, request);
                if (res != null) {
                    Map<String, String> headers = res.getResponseHeaders() == null
                        ? new HashMap<>() : new HashMap<>(res.getResponseHeaders());
                    headers.put("Cross-Origin-Opener-Policy", "same-origin");
                    headers.put("Cross-Origin-Embedder-Policy", "require-corp");
                    res.setResponseHeaders(headers);
                }
                return res;
            }
        });
    }
}
