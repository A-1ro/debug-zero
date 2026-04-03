import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TopView }     from "./views/TopView";
import { RoomView }    from "./views/RoomView";
import { SessionView } from "./views/SessionView";
import { ResultView }  from "./views/ResultView";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"                    element={<TopView />} />
        <Route path="/room/:roomId"        element={<RoomView />} />
        <Route path="/room/:roomId/game"   element={<SessionView />} />
        <Route path="/room/:roomId/result" element={<ResultView />} />
      </Routes>
    </BrowserRouter>
  );
}
