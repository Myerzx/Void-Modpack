import java.io.BufferedReader;
import java.io.InputStreamReader;

public final class FakeMinecraftFixture {
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("flood")) {
            System.out.println("x".repeat(100_000));
            return;
        }

        System.out.println("[Server thread/INFO]: Done (0.100s)! For help, type \"help\"");
        System.out.flush();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = input.readLine()) != null) {
            if (line.equals("stop")) {
                System.out.println("[Server thread/INFO]: Stopping server");
                System.out.flush();
                return;
            }
            if (line.equals("list")) {
                System.out.println("[Server thread/INFO]: There are 0 of a max of 20 players online");
                System.out.flush();
                continue;
            }
            if (line.equals("save-all flush")) {
                System.out.println("[Server thread/INFO]: Saved the game");
                System.out.flush();
                continue;
            }
            System.err.println("[Server thread/ERROR]: Unexpected command");
            System.err.flush();
        }
    }
}
