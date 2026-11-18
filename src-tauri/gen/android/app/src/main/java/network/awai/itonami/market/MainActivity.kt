package network.awai.itonami.market

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    val surface = Color.rgb(237, 243, 245)
    enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, surface))
    super.onCreate(savedInstanceState)

    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(surface)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safeArea = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(safeArea.left, safeArea.top, safeArea.right, safeArea.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }
}
