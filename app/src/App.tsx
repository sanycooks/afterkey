import { useEffect, useState } from 'react'
import { PrefsProvider } from './lib/prefs'
import AppPage from './pages/AppPage'
import Landing from './pages/Landing'

function useRoute() {
  const get = () => (location.hash.startsWith('#/app') ? 'app' : 'landing')
  const [route, setRoute] = useState(get)
  useEffect(() => {
    const on = () => setRoute(get())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export default function App() {
  const route = useRoute()
  return <PrefsProvider>{route === 'app' ? <AppPage /> : <Landing />}</PrefsProvider>
}
