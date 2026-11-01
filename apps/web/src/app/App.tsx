import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from '@/shared/theme/theme'
import { EntryPage } from '@/pages/EntryPage'
import { RoomPage } from '@/pages/RoomPage'
import { SharePage } from '@/pages/SharePage'
import { NotFoundPage } from '@/pages/NotFoundPage'

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<EntryPage />} />
          <Route path="/rooms/:roomId" element={<RoomPage />} />
          <Route path="/s/:slug" element={<SharePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}
